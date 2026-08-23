import Link from 'next/link';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { users, watchHistory } from '@/db/schema';
import { formatDate, formatDuration } from '@/components/format';
import { requireAdmin } from '@/server/session';
import SyncUsersButton from './SyncUsersButton';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  await requireAdmin();

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      lastSeenAt: users.lastSeenAt,
      plays: sql<number>`count(${watchHistory.id})`,
      watchtime: sql<number>`coalesce(sum(${watchHistory.durationMs}), 0)`,
    })
    .from(users)
    .leftJoin(watchHistory, sql`${watchHistory.userId} = ${users.id}`)
    .groupBy(users.id)
    .orderBy(desc(sql`count(${watchHistory.id})`));

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Users</h1>
      <p className="subtitle">Everyone known to this deployment. Import pulls in server accounts that never signed in.</p>
      <SyncUsersButton />

      <div className="table-wrap card section">
        <table>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Role</th>
              <th scope="col">Plays</th>
              <th scope="col">Watch time</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/users/${row.id}`}>{row.username}</Link>
                </td>
                <td>{row.isAdmin ? 'Admin' : 'User'}</td>
                <td>{row.plays}</td>
                <td>{formatDuration(Number(row.watchtime))}</td>
                <td>{row.lastSeenAt ? formatDate(row.lastSeenAt) : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
