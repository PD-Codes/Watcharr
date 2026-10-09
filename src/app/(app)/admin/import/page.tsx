import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { listServers } from '@/server/config';
import { IMPORT_DIR, getJob } from '@/server/importjob';
import { CHUNK_BYTES, listUploads } from '@/server/importupload';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import ImportForm from './ImportForm';

export const dynamic = 'force-dynamic';

export default async function AdminImportPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [servers, accounts, uploads, job] = await Promise.all([
    listServers(),
    db.select({ id: users.id, serverId: users.serverId, username: users.username }).from(users).orderBy(users.username),
    listUploads(IMPORT_DIR),
    getJob(),
  ]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('import.title')}</h1>
      <p className="subtitle">{t('import.subtitle')}</p>
      <ImportForm
        servers={servers.map((server) => ({ id: server.id, label: server.label }))}
        accounts={accounts}
        initialUploads={uploads}
        initialJob={job}
        chunkBytes={CHUNK_BYTES}
      />
    </>
  );
}
