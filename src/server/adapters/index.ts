import { JellyfinAdapter } from './jellyfin';
import { PlexAdapter } from './plex';
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
