import { formatDate } from '@/components/format';
import IpLink from '@/components/IpLink';
import { listLoginHistory, requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminSecurityPage() {
  const { user } = await requireAdmin();
  const rows = await listLoginHistory(user.globalAdmin ? undefined : user.serverId);

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Security</h1>
      <p className="subtitle">Recent sign-in attempts, successful and failed.</p>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Result</th>
              <th>IP</th>
              <th>Country</th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.createdAt)}</td>
                <td>{row.username}</td>
                <td className={row.success ? undefined : 'error'}>
                  {row.success ? 'Success' : 'Failed'}
                </td>
                <td>
                  <IpLink ip={row.ip} />
                </td>
                <td>{row.country ?? '—'}</td>
                <td>{row.userAgent ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No login attempts recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
