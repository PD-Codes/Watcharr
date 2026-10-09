import Link from 'next/link';
import { listCustomBadges } from '@/server/badges';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import BadgeForm from './BadgeForm';
import DeleteBadgeButton from './DeleteBadgeButton';

export const dynamic = 'force-dynamic';

export default async function AdminBadgesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  await requireGlobalAdmin();
  const t = await getT();
  const badges = await listCustomBadges();
  const { edit } = await searchParams;
  const editing = badges.find((badge) => String(badge.id) === edit);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminBadges')}</h1>
      <p className="subtitle">{t('badges.subtitle')}</p>

      <div className="table-wrap card section">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('badges.name')}</th>
              <th scope="col">{t('badges.rule')}</th>
              <th scope="col" className="secondary-col">{t('badges.tiers')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {badges.map((badge) => (
              <tr key={badge.id}>
                <td>
                  <span aria-hidden>{badge.icon}</span> {badge.name}
                  {badge.description && <div className="muted">{badge.description}</div>}
                </td>
                <td>
                  {t(`badges.metric.${badge.metric}`)}
                  {badge.filter !== 'none' && ` · ${t(`badges.filter.${badge.filter}`)}: ${badge.filterValue}`}
                </td>
                <td className="secondary-col num">{badge.tiers.join(' · ')}</td>
                <td>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Link href={`/admin/badges?edit=${badge.id}`} className="button outlined">
                      {t('badges.edit')}
                    </Link>
                    <DeleteBadgeButton id={badge.id} name={badge.name} />
                  </div>
                </td>
              </tr>
            ))}
            {badges.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t('badges.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <BadgeForm
          key={editing.id}
          id={editing.id}
          initial={{
            name: editing.name,
            description: editing.description,
            icon: editing.icon,
            metric: editing.metric,
            filter: editing.filter,
            filterValue: editing.filterValue,
            tiers: editing.tiers.join(', '),
          }}
        />
      ) : (
        <BadgeForm />
      )}
    </>
  );
}
