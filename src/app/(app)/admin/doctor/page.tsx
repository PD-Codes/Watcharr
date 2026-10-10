import { runDoctor } from '@/server/doctor';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const FIX: Record<string, string> = {
  backup: '/admin/backups',
  migrations: '/admin/system',
  servers: '/admin/servers',
  email: '/admin/notifications',
  tmdb: '/admin/config',
  timezone: '/admin/config',
  update: '/admin/system',
  import: '/admin/import',
  restore: '/admin/backups',
};

const mb = (bytes: number) => (bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export default async function AdminDoctorPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const { checks, usage } = await runDoctor();
  const problems = checks.filter((c) => c.level !== 'ok').length;
  // Dynamic keys, built from the check id: the id set lives in doctor-core.ts.
  const text = (key: string, params?: Record<string, string | number>) => t(key as 'doctor.secret', params);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminDoctor')}</h1>
      <p className="subtitle">{problems === 0 ? t('doctor.allGood') : t('doctor.problems', { count: problems })}</p>

      <ul className="card section" style={{ listStyle: 'none', padding: 16, margin: 0 }}>
        {checks.map((check) => (
          <li key={check.id} className="row" style={{ gap: 12, alignItems: 'baseline', padding: '8px 0' }}>
            <span
              aria-label={t(`doctor.level.${check.level}` as 'doctor.level.ok')}
              style={{ width: 20, fontWeight: 700, color: check.level === 'fail' ? 'var(--danger)' : undefined }}
            >
              {check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : '✕'}
            </span>
            {/* min-width 0 lets the text shrink inside the flex row, and long unbroken values (a
                plex.direct host, a data path) wrap instead of widening the page on a phone. */}
            <span style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
              <strong>{text(`doctor.${check.id}`)}</strong>
              <br />
              <span className="muted">{text(`doctor.${check.id}.${check.level}`, check.params)}</span>
              {check.level !== 'ok' && FIX[check.id] && (
                <>
                  {' '}
                  <a href={FIX[check.id]}>{t('doctor.fix')}</a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="section">{t('doctor.usage')}</h2>
      <div className="card table-wrap">
        <table>
          <tbody>
            {usage.map((u) => (
              <tr key={u.label}>
                <td>{text(`doctor.usage.${u.label}`)}</td>
                <td>{mb(u.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
