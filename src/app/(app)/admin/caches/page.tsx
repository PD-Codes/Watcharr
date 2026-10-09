import { getCacheStats } from '@/server/caches';
import { getSettings } from '@/server/config';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import CachesManager from './CachesManager';

export const dynamic = 'force-dynamic';

export default async function AdminCachesPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [stats, settings] = await Promise.all([getCacheStats(), getSettings()]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminCaches')}</h1>
      <p className="subtitle">{t('caches.subtitle')}</p>
      <CachesManager initial={stats} tmdbConfigured={Boolean(settings.tmdbApiKey)} />
    </>
  );
}
