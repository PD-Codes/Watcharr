import { listServers } from '@/server/config';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import ImportForm from './ImportForm';

export const dynamic = 'force-dynamic';

export default async function AdminImportPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const servers = await listServers();

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('import.title')}</h1>
      <p className="subtitle">{t('import.subtitle')}</p>
      <ImportForm servers={servers.map((server) => ({ id: server.id, label: server.label }))} />
    </>
  );
}
