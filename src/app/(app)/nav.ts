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
    { href: '/pick', label: t('nav.pick'), icon: 'dice' },
    { href: '/history', label: t('nav.history'), icon: 'history' },
    { href: '/activity', label: t('nav.activity'), icon: 'activity' },
    { href: '/screen', label: t('screen.title'), icon: 'monitor' },
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

/** A collapsible block of the admin navigation. */
export interface NavGroup {
  key: AdminGroupKey;
  label: string;
  icon: IconName;
  items: NavItem[];
}

export type AdminGroupKey = 'live' | 'access' | 'analysis' | 'content' | 'setup' | 'system';

/**
 * Admin-only destinations, in collapsible groups. Eighteen flat entries under thirteen user
 * ones made the sidebar taller than any laptop screen; grouped, only the block you work in
 * is open. Server management is reserved for global admins, and a group that ends up empty
 * for this admin is dropped rather than shown as a heading over nothing.
 */
export function adminGroups(t: Translate, serverStatsEnabled: boolean, globalAdmin = false): NavGroup[] {
  const groups: NavGroup[] = [
    {
      key: 'live',
      label: t('ui2.nav.groupLive'),
      icon: 'activity',
      items: [
        { href: '/admin/activity', label: t('nav.adminActivity'), icon: 'activity' },
        { href: '/admin/streams', label: t('nav.adminStreams'), icon: 'transcode' },
        { href: '/admin/transcoding', label: t('nav.adminTranscoding'), icon: 'transcode' },
        { href: '/admin/clients', label: t('nav.adminClients'), icon: 'devices' },
      ],
    },
    {
      key: 'access',
      label: t('ui2.nav.groupAccess'),
      icon: 'users',
      items: [
        { href: '/admin/users', label: t('nav.adminUsers'), icon: 'users' },
        { href: '/admin/security', label: t('nav.adminSecurity'), icon: 'users' },
      ],
    },
    {
      key: 'analysis',
      label: t('ui2.nav.groupAnalysis'),
      icon: 'stats',
      items: [
        ...(serverStatsEnabled
          ? [{ href: '/admin/stats', label: t('nav.adminStats'), icon: 'stats' as const }]
          : []),
        { href: '/admin/graphs', label: t('nav.adminGraphs'), icon: 'stats' },
      ],
    },
    {
      key: 'content',
      label: t('ui2.nav.groupContent'),
      icon: 'wrapped',
      items: globalAdmin
        ? [
            { href: '/admin/newsletter', label: t('nav.adminNewsletter'), icon: 'wrapped' },
            { href: '/admin/badges', label: t('nav.adminBadges'), icon: 'trophy' },
            { href: '/admin/import', label: t('nav.adminImport'), icon: 'download' },
          ]
        : [],
    },
    {
      // Split from "system" so no group is taller than four rows: the open group has to fit
      // next to thirteen user destinations on a 1000px screen.
      key: 'setup',
      label: t('ui2.nav.groupSetup'),
      icon: 'settings',
      items: globalAdmin
        ? [
            { href: '/admin/servers', label: t('nav.adminServers'), icon: 'server' },
            { href: '/admin/notifications', label: t('nav.adminNotifications'), icon: 'bell' },
            { href: '/admin/config', label: t('nav.adminConfig'), icon: 'settings' },
          ]
        : [],
    },
    {
      key: 'system',
      label: t('ui2.nav.groupSystem'),
      icon: 'server',
      items: [
        { href: '/admin/system', label: t('nav.adminSystem'), icon: 'server' },
        ...(globalAdmin
          ? [
              { href: '/admin/doctor', label: t('nav.adminDoctor'), icon: 'settings' as const },
              { href: '/admin/backups', label: t('nav.adminBackups'), icon: 'download' as const },
              { href: '/admin/caches', label: t('nav.adminCaches'), icon: 'server' as const },
            ]
          : []),
      ],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** Admin-only destinations as one flat list (command palette, tests). */
export function adminNav(t: Translate, serverStatsEnabled: boolean, globalAdmin = false): NavItem[] {
  return adminGroups(t, serverStatsEnabled, globalAdmin).flatMap((group) => group.items);
}

/** The group holding the page you are on, or null outside the admin area. */
export function activeGroup(groups: { key: string; items: { href: string }[] }[], pathname: string): string | null {
  return groups.find((group) => group.items.some((item) => isActive(pathname, item.href)))?.key ?? null;
}

/**
 * Which groups are open. The group of the current page opens on arrival — landing on a page
 * that is hidden in the navigation reads as "where am I" — unless it was closed again on
 * this very page (`activeClosed`). Every other group follows the remembered choice and is
 * closed without one.
 */
export function openGroups(
  keys: readonly string[],
  active: string | null,
  remembered: Record<string, boolean>,
  activeClosed = false,
): Record<string, boolean> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      key === active && !activeClosed ? true : (remembered[key] ?? false),
    ]),
  );
}

/** Parses the remembered open/closed map; anything unexpected counts as "nothing remembered". */
export function parseRemembered(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The modifier shown next to "K" on the search trigger. Read from the platform string, so a
 * Windows or Linux user is not told to press a key their keyboard does not have.
 */
export function modifierLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
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
