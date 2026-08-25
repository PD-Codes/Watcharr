// No 'server-only' here: itemDeepLink is pure and must stay unit-testable. getServer()
// carries the server-only marker itself, so the config path is still protected.
import { getServer } from './config';

// Same reasoning as the artwork proxy: the item id is attacker-controlled. Anything outside
// this set could escape the path (`../`) or open a fragment/query of its own.
const SAFE_ITEM_ID = /^[A-Za-z0-9._:-]+$/;

/** Link that opens an item in the media server's own web UI, or null if not buildable. */
export function itemDeepLink(
  serverType: string,
  serverUrl: string,
  itemId: string,
): string | null {
  if (!SAFE_ITEM_ID.test(itemId)) return null;

  let base: string;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    base = serverUrl.replace(/\/+$/, '');
  } catch {
    return null;
  }

  const id = encodeURIComponent(itemId);
  switch (serverType) {
    case 'jellyfin':
      return `${base}/web/index.html#/details?id=${id}`;
    case 'emby':
      return `${base}/web/index.html#!/item?id=${id}`;
    // ponytail: Plex web links need the server's machine identifier
    // (/index.html#!/server/<machineId>/details?key=…), which we never store. Upgrade path:
    // persist machineIdentifier in app_config during setup, then build the link here.
    default:
      return null;
  }
}

/** Deep link into one server's own web UI, or null when it cannot be built. */
export async function getItemDeepLink(serverId: number, itemId: string): Promise<string | null> {
  const server = await getServer(serverId);
  return server ? itemDeepLink(server.serverType, server.serverUrl, itemId) : null;
}
