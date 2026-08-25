import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, users, watchHistory } from '@/db/schema';
import { formatDate, formatDuration } from '@/components/format';
import { requireAdmin } from '@/server/session';
import SyncUsersButton from './SyncUsersButton';
import RoleToggle from './RoleToggle';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const session = await requireAdmin();
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
      <p className="eyebrow">Admin</p>
      <h1>Users</h1>
      <p className="subtitle">
        {global
          ? 'Everyone known to this deployment. Import pulls in server accounts that never signed in.'
          : 'Everyone on your server. Import pulls in accounts that never signed in.'}
      </p>
      <SyncUsersButton />

      <div className="table-wrap card section">
        <table>
          <thead>
            <tr>
              <th scope="col">User</th>
              {global && <th scope="col">Server</th>}
              <th scope="col">Role</th>
              <th scope="col">Plays</th>
              <th scope="col">Watch time</th>
              <th scope="col">Last seen</th>
              {global && <th scope="col">Global admin</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/users/${row.id}`}>{row.username}</Link>
                </td>
                {global && <td>{row.serverLabel ?? '—'}</td>}
                <td>
                  {row.globalAdmin ? 'Global admin' : row.isAdmin ? 'Server admin' : 'User'}
                </td>
                <td>{row.plays}</td>
                <td>{formatDuration(Number(row.watchtime))}</td>
                <td>{row.lastSeenAt ? formatDate(row.lastSeenAt) : 'never'}</td>
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
