import { getConfig } from '@/server/config';
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
export default async function OpenInServer({ itemId }: { itemId: string | null }) {
  if (!itemId) return null;
  const config = await getConfig();
  if (!config) return null;

  const href = itemDeepLink(config.serverType, config.serverUrl, itemId);
  if (!href) return null;

  const name = config.serverName || SERVER_LABEL[config.serverType] || 'the server';

  return (
    <a className="link-out" href={href} target="_blank" rel="noreferrer noopener">
      <Icon name="external" />
      Open in {name}
    </a>
  );
}
