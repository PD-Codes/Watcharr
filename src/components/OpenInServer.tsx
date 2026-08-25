import { getServer } from '@/server/config';
import { itemDeepLink } from '@/server/deeplink';
import { Icon } from './Icons';

const SERVER_LABEL: Record<string, string> = {
  jellyfin: 'Jellyfin',
  emby: 'Emby',
  plex: 'Plex',
};

/**
 * Hands the item over to the media server's own web UI, which is where playback,
 * requests and metadata editing actually live. Renders nothing when no link can be
 * built — Plex needs a machine identifier this app does not store.
 */
export default async function OpenInServer({
  itemId,
  serverId,
}: {
  itemId: string | null;
  serverId: number;
}) {
  if (!itemId) return null;
  const server = await getServer(serverId);
  if (!server) return null;

  const href = itemDeepLink(server.serverType, server.serverUrl, itemId);
  if (!href) return null;

  const name = server.label || server.serverName || SERVER_LABEL[server.serverType] || 'the server';

  return (
    <a className="link-out" href={href} target="_blank" rel="noreferrer noopener">
      <Icon name="external" />
      Open in {name}
    </a>
  );
}
