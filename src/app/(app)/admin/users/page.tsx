import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, users, watchHistory } from '@/db/schema';
import { formatDate, formatDuration } from '@/components/format';
import { requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import SyncUsersButton from './SyncUsersButton';
import RoleToggle from './RoleToggle';
import DeleteUserButton from './DeleteUserButton';
import ViewAsButton from '../../ViewAsButton';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const session = await requireAdmin();
  const t = await getT();
  const global = session.user.globalAdmin;

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      globalAdmin: users.globalAdmin,
      serverLabel: appConfig.label,
      lastSeenAt: users.lastSeenAt,
      plays: sql<number>`count(${watchHistory.id})`,
      watchtime: sql<number>`coalesce(sum(${watchHistory.durationMs}), 0)`,
    })
    .from(users)
    .leftJoin(watchHistory, sql`${watchHistory.userId} = ${users.id}`)
    .leftJoin(appConfig, eq(appConfig.id, users.serverId))
    // A server admin administers their own server, so other servers' accounts are none of
    // their business — not even by name.
    .where(global ? sql`1 = 1` : eq(users.serverId, session.user.serverId))
    .groupBy(users.id)
    .orderBy(desc(sql`count(${watchHistory.id})`));

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminUsers')}</h1>
      <p className="subtitle">
        {global ? t('users.subtitleGlobal') : t('users.subtitleServer')}
      </p>
      <SyncUsersButton />

      {global && (
        <details className="card section">
          <summary>{t('users.globalInfoTitle')}</summary>
          <p>{t('users.globalInfoIntro')}</p>
          <ul>
            <li>{t('users.globalInfo1')}</li>
            <li>{t('users.globalInfo2')}</li>
            <li>{t('users.globalInfo3')}</li>
            <li>{t('users.globalInfo4')}</li>
          </ul>
          <p className="muted">{t('users.globalInfoNote')}</p>
        </details>
      )}

      <div className="table-wrap card section">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('common.user')}</th>
              {global && <th scope="col" className="secondary-col">{t('users.colServer')}</th>}
              <th scope="col">{t('users.colRole')}</th>
              <th scope="col" className="secondary-col">{t('users.colPlays')}</th>
              <th scope="col">{t('common.watchTime')}</th>
              <th scope="col">{t('users.colLastSeen')}</th>
              <th scope="col">{t('viewAs.column')}</th>
              <th scope="col">{t('users.colDelete')}</th>
              {global && <th scope="col">{t('users.colGlobalAdmin')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/users/${row.id}`}>{row.username}</Link>
                </td>
                {global && <td className="secondary-col">{row.serverLabel ?? '—'}</td>}
                <td>
                  {row.globalAdmin
                    ? t('users.roleGlobalAdmin')
                    : row.isAdmin
                      ? t('users.roleServerAdmin')
                      : t('users.roleUser')}
                </td>
                <td className="secondary-col">{row.plays}</td>
                <td>{formatDuration(Number(row.watchtime))}</td>
                <td className="when-cell">
                  {row.lastSeenAt ? formatDate(row.lastSeenAt) : t('common.never')}
                </td>
                <td>{row.id !== session.user.id && <ViewAsButton userId={row.id} />}</td>
                <td>
                  {/* A global admin has to lose the role first; yourself you cannot delete. */}
                  {row.id !== session.user.id && !row.globalAdmin && (
                    <DeleteUserButton userId={row.id} username={row.username} plays={Number(row.plays)} />
                  )}
                </td>
                {global && (
                  <td>
                    <RoleToggle
                      userId={row.id}
                      username={row.username}
                      globalAdmin={row.globalAdmin}
                      self={row.id === session.user.id}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
