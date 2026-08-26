import { formatDate } from '@/components/format';
import IpLink from '@/components/IpLink';
import { listLoginHistory, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function AdminSecurityPage() {
  const { user } = await requireAdmin();
  const t = await getT();
  const rows = await listLoginHistory(user.globalAdmin ? undefined : user.serverId);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminSecurity')}</h1>
      <p className="subtitle">{t('security.subtitle')}</p>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>{t('security.when')}</th>
              <th>{t('common.user')}</th>
              <th>{t('security.result')}</th>
              <th>{t('security.ip')}</th>
              <th>{t('security.country')}</th>
              <th>{t('security.client')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.createdAt)}</td>
                <td>{row.username}</td>
                <td className={row.success ? undefined : 'error'}>
                  {row.success ? t('security.success') : t('security.failed')}
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
                  {t('security.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
