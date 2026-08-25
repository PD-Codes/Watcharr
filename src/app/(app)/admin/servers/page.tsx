import { formatDate } from '@/components/format';
import { listServers } from '@/server/config';
import { requireGlobalAdmin } from '@/server/session';
import ServersManager from './ServersManager';

// No loading.tsx in this segment. See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

export default async function AdminServersPage() {
  const session = await requireGlobalAdmin();
  const servers = await listServers();

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Servers</h1>
      <p className="subtitle">
        Every connected media server. Each account belongs to exactly one of them, and the
        sign-in screen only offers a choice while more than one is configured.
      </p>

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
