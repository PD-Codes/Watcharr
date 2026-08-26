import { formatDate } from '@/components/format';
import { listServers } from '@/server/config';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import ServersManager from './ServersManager';

// No loading.tsx in this segment. See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

export default async function AdminServersPage() {
  const session = await requireGlobalAdmin();
  const t = await getT();
  const servers = await listServers();

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminServers')}</h1>
      <p className="subtitle">{t('servers.subtitle')}</p>

      <ServersManager
        currentServerId={session.user.serverId}
        servers={servers.map((server) => ({
          id: server.id,
          label: server.label,
          slug: server.slug,
          serverType: server.serverType,
          serverUrl: server.serverUrl,
          serverName: server.serverName,
          addedAt: formatDate(server.createdAt),
        }))}
      />
    </>
  );
}
