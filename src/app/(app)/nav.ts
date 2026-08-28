import type { IconName } from '@/components/Icons';
import type { Translate } from '@/i18n';

// One definition of the navigation, shared by the permanent drawer, the modal drawer
// and the bottom bar. Three copies of this list drifted apart the moment a route moved.

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Destinations every signed-in user has. */
export function userNav(t: Translate, suggestionsEnabled: boolean): NavItem[] {
  return [
    { href: '/', label: t('nav.overview'), icon: 'overview' },
    { href: '/sessions', label: t('nav.sessions'), icon: 'activity' },
    { href: '/watchlist', label: t('nav.watchlist'), icon: 'watchlist' },
    { href: '/history', label: t('nav.history'), icon: 'history' },
    { href: '/activity', label: t('nav.activity'), icon: 'activity' },
    { href: '/stats', label: t('nav.stats'), icon: 'stats' },
    { href: '/libraries', label: t('nav.libraries'), icon: 'server' },
    ...(suggestionsEnabled
      ? [{ href: '/suggestions', label: t('nav.suggestions'), icon: 'suggestions' as const }]
      : []),
    { href: '/wrapped', label: t('nav.wrapped'), icon: 'wrapped' },
    { href: '/notifications', label: t('nav.notifications'), icon: 'bell' },
    { href: '/profile', label: t('nav.profile'), icon: 'users' },
  ];
}

/** Admin-only destinations. Server management is reserved for global admins. */
export function adminNav(t: Translate, serverStatsEnabled: boolean, globalAdmin = false): NavItem[] {
  return [
    { href: '/admin/activity', label: t('nav.adminActivity'), icon: 'activity' },
    { href: '/admin/users', label: t('nav.adminUsers'), icon: 'users' },
    ...(serverStatsEnabled
      ? [{ href: '/admin/stats', label: t('nav.adminStats'), icon: 'stats' as const }]
      : []),
    { href: '/admin/graphs', label: t('nav.adminGraphs'), icon: 'stats' },
    { href: '/admin/streams', label: t('nav.adminStreams'), icon: 'transcode' },
    { href: '/admin/transcoding', label: t('nav.adminTranscoding'), icon: 'transcode' },
    { href: '/admin/clients', label: t('nav.adminClients'), icon: 'devices' },
    { href: '/admin/system', label: t('nav.adminSystem'), icon: 'server' },
    { href: '/admin/security', label: t('nav.adminSecurity'), icon: 'users' },
    ...(globalAdmin
      ? [
          { href: '/admin/servers', label: t('nav.adminServers'), icon: 'server' as const },
          { href: '/admin/notifications', label: t('nav.adminNotifications'), icon: 'activity' as const },
          { href: '/admin/newsletter', label: t('nav.adminNewsletter'), icon: 'wrapped' as const },
          { href: '/admin/import', label: t('nav.adminImport'), icon: 'server' as const },
          { href: '/admin/config', label: t('nav.adminConfig'), icon: 'settings' as const },
        ]
      : []),
  ];
}

/**
 * The five destinations that reach the bottom bar on a phone. Material caps a
 * navigation bar at five; everything else lives in the drawer behind the menu button.
 */
export function bottomNav(t: Translate, suggestionsEnabled: boolean): NavItem[] {
  return [
    { href: '/', label: t('nav.overview'), icon: 'overview' },
    { href: '/activity', label: t('nav.activity'), icon: 'activity' },
    { href: '/history', label: t('nav.history'), icon: 'history' },
    { href: '/stats', label: t('nav.stats'), icon: 'stats' },
    suggestionsEnabled
      ? { href: '/suggestions', label: t('nav.suggestions'), icon: 'suggestions' }
      : { href: '/watchlist', label: t('nav.watchlist'), icon: 'watchlist' },
  ];
}

/** Marks the section you are in. Nested routes keep their parent highlighted. */
export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}
