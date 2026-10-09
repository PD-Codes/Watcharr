import type { MetadataRoute } from 'next';

/*
 * Makes Watcharr installable ("Add to home screen", a kiosk window on a lobby PC).
 *
 * There is deliberately NO service worker. This is a live stats app: an offline shell
 * would show stale "now playing" and old numbers as if they were current, and a worker
 * adds a cache that can serve an outdated build after an update. Installability here
 * only needs this manifest, which every current browser honors without one.
 *
 * Names stay English: a manifest is one static file per origin, fetched without a
 * session, so it cannot know which language the signed-in person chose.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Watcharr',
    short_name: 'Watcharr',
    description: 'Companion app for Plex, Jellyfin and Emby',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    // The dark --ink, so the splash screen and the title bar match the app's own first paint.
    background_color: '#08090b',
    theme_color: '#08090b',
    icons: [
      { src: '/icon/any-192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon/any-512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon/maskable-512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Activity', url: '/activity' },
      { name: 'Pick something', url: '/pick' },
      { name: 'Lobby display', url: '/screen' },
    ],
  };
}
