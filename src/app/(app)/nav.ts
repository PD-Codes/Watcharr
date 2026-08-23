import type { IconName } from '@/components/Icons';
import { t } from '@/i18n';

// One definition of the navigation, shared by the permanent drawer, the modal drawer
// and the bottom bar. Three copies of this list drifted apart the moment a route moved.

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Destinations every signed-in user has. */
export function userNav(suggestionsEnabled: boolean): NavItem[] {
  return [
    { href: '/', label: t('nav.overview'), icon: 'overview' },
    { href: '/watchlist', label: t('nav.watchlist'), icon: 'watchlist' },
    { href: '/history', label: t('nav.history'), icon: 'history' },
    { href: '/activity', label: t('nav.activity'), icon: 'activity' },
    { href: '/stats', label: t('nav.stats'), icon: 'stats' },
    ...(suggestionsEnabled
      ? [{ href: '/suggestions', label: t('nav.suggestions'), icon: 'suggestions' as const }]
      : []),
    { href: '/wrapped', label: t('nav.wrapped'), icon: 'wrapped' },
  ];
}

/** Admin-only destinations. */
export function adminNav(serverStatsEnabled: boolean): NavItem[] {
  return [
    { href: '/admin/activity', label: t('nav.adminActivity'), icon: 'activity' },
    { href: '/admin/users', label: t('nav.adminUsers'), icon: 'users' },
    ...(serverStatsEnabled
      ? [{ href: '/admin/stats', label: t('nav.adminStats'), icon: 'stats' as const }]
      : []),
    { href: '/admin/transcoding', label: t('nav.adminTranscoding'), icon: 'transcode' },
    { href: '/admin/clients', label: t('nav.adminClients'), icon: 'devices' },
    { href: '/admin/system', label: t('nav.adminSystem'), icon: 'server' },
    { href: '/admin/config', label: t('nav.adminConfig'), icon: 'settings' },
  ];
}

/**
 * The five destinations that reach the bottom bar on a phone. Material caps a
 * navigation bar at five; everything else lives in the drawer behind the menu button.
 */
export function bottomNav(suggestionsEnabled: boolean): NavItem[] {
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
