import { formatDate } from '@/components/format';
import { canRestart, listBackups, pendingRestore } from '@/server/backups';
import { getSettings } from '@/server/config';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import BackupsManager from './BackupsManager';

export const dynamic = 'force-dynamic';

export default async function AdminBackupsPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [backups, pending, settings] = await Promise.all([listBackups(), pendingRestore(), getSettings()]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminBackups')}</h1>
      <p className="subtitle">{t('backups.subtitle')}</p>
      <p className="muted">
        {settings.backupAutoEnabled
          ? t('backups.scheduleOn', { hours: settings.backupIntervalHours, count: settings.backupRetention })
          : t('backups.scheduleOff')}{' '}
        {settings.backupLastAt && t('backups.lastScheduled', { date: formatDate(settings.backupLastAt) })}{' '}
        <a href="/admin/config">{t('backups.changeSchedule')}</a>
      </p>
      <BackupsManager
        backups={backups.map((b) => ({ ...b, createdAt: formatDate(b.createdAt) }))}
        pending={pending}
        canRestart={canRestart()}
      />
    </>
  );
}
