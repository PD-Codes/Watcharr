import { JellyfinAdapter } from './jellyfin';
import { PlexAdapter } from './plex';
import { plexRoute } from './plexroute';
import type { MediaServerAdapter, ServerType } from './types';

export const SERVER_TYPES: ServerType[] = ['plex', 'jellyfin', 'emby'];

export function createAdapter(
  type: ServerType,
  baseUrl: string,
  token: string,
): MediaServerAdapter {
  switch (type) {
    case 'plex':
      return new PlexAdapter(baseUrl, token);
    case 'jellyfin':
    case 'emby':
      return new JellyfinAdapter(type, baseUrl, token);
    default:
      throw new Error(`Unsupported server type: ${type satisfies never}`);
  }
}

export * from './types';

/**
 * The address a server's requests actually go to. Plex may be reached through a detour that
 * plexroute.ts found when the configured URL does not answer; whatever keys on the host
 * (backoff, the artwork origin check) has to follow it.
 */
export function serverRoute(type: string, url: string): string {
  return type === 'plex' ? plexRoute(url) : url;
}
